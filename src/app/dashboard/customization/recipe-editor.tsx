"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { AlertCircle, CheckCircle2, FileCode, GitMerge, History, LayoutList, RotateCcw, Save } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { runnable } from "../../../../recipes/compose";
import { conflictsIn, merge3, resolveConflict } from "../../../../recipes/merge";
import type { PageObject } from "../../../../recipes/kernel";
import { parseRecipe, type CompiledRecipe, type Problem } from "../../../../recipes/md/parse";
import { workspaceProblems } from "../../../../recipes/workspace";
import { LoadingRows } from "@/components/dashboard";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { draftReducer, isDirty, openDraft } from "./editor-draft";
import { LayoutMode } from "./layout-mode";
import { DiffView, RecipeAgentPane } from "./recipe-agent-pane";
import { RecipePreview, pageAtLine } from "./recipe-preview";
import { RecipesSubpage } from "./workspace-page";

type View = Extract<NonNullable<FunctionReturnType<typeof api.workspaceRecipes.editor>>, { found: true }>;
type Revision = View["revisions"][number];

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const LINE_PX = 20;
const CHECK_DELAY_MS = 250;

/**
 * A workspace recipe's recipe.md (docs/recipes.md, "Customizing in the app"): a plain editor checked as you type by
 * the same parser and rules the save runs, with each problem at its line, and the revisions with their diffs.
 */
export function RecipeEditor({ recipeId }: { recipeId: string }) {
  const view = useQuery(api.workspaceRecipes.editor, { recipeId });
  if (view === undefined) return <RecipesSubpage title="customization.md" description="Loading the customization."><LoadingRows count={3} height="h-28" /></RecipesSubpage>;
  if (view === null || !view.found) {
    return <RecipesSubpage title="customization.md" description={`This workspace has no customization of its own called ${recipeId}. Customize one on the Customization page.`}><span /></RecipesSubpage>;
  }
  return <Editor key={view.recipeId} view={view} />;
}

type Checked = { problems: Problem[]; recipe: CompiledRecipe };
type EvalView = { name: string; ok: boolean; detail: string | null };
/** The evals a save ran: blocking it until the admin saves anyway, or reported once it saved. */
type EvalGate = { evals: EvalView[]; notRun: string | null; blocked: boolean };

function Editor({ view }: { view: View }) {
  const save = useAction(api.workspaceRecipes.save);
  const revert = useAction(api.workspaceRecipes.revert);
  const fetchUpstream = useAction(api.workspaceRecipes.upstream);
  const [state, dispatch] = useReducer(draftReducer, view, (v) => openDraft(v.revision, v.markdown));
  const { draft, base } = state;
  const setDraft = (text: string) => dispatch({ kind: "edit", draft: text });
  const [checked, setChecked] = useState<Checked>(() => checkDraft(view.markdown, view, view.markdown));
  // The preview keeps the last draft that checked clean, and says so once the draft has errors.
  const [good, setGood] = useState<CompiledRecipe>(() => checked.recipe);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [mode, setMode] = useState<"visual" | "markdown">("visual");
  const [gate, setGate] = useState<EvalGate | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [caretLine, setCaretLine] = useState(1);
  // The page picked in Visual; Markdown's preview follows the caret instead.
  const [visualPage, setVisualPage] = useState<PageObject>("deal");
  // A line to select once Markdown shows, for a jump made from Visual.
  const pendingJump = useRef<number | null>(null);
  // A merge's upstream text: a kept bundle's prompts and logic are checked against the upstream's while merging.
  const [theirs, setTheirs] = useState<string | null>(null);
  const frozenFrom = state.merging && theirs !== null ? theirs : base.markdown;
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const dirty = isDirty(state);
  // What an async reply merges into: the draft as it is when the reply lands, not when the request left.
  const latestDraft = useRef(draft);
  latestDraft.current = draft;

  // A save from elsewhere (another tab, a revert) lands here when nothing is being edited, or once the edits are discarded.
  useEffect(() => {
    dispatch({ kind: "landed", revision: view.revision, markdown: view.markdown });
  }, [view.revision, view.markdown, dirty]);

  useEffect(() => {
    const t = setTimeout(() => {
      const next = checkDraft(draft, view, frozenFrom);
      setChecked(next);
      if (!next.problems.some((p) => p.level === "error")) setGood(next.recipe);
    }, CHECK_DELAY_MS);
    return () => clearTimeout(t);
  }, [draft, view, frozenFrom]);

  // The evals a blocked save ran were for that draft; an edit since makes them old.
  useEffect(() => setGate((g) => (g?.blocked ? null : g)), [draft]);

  const errors = checked.problems.filter((p) => p.level === "error");
  const warnings = checked.problems.filter((p) => p.level === "warning");
  const lines = useMemo(() => draft.split("\n").length, [draft]);
  const errorLines = useMemo(() => new Set(errors.map((p) => p.line)), [errors]);
  const conflicts = useMemo(() => conflictsIn(draft), [draft]);
  const caretPage = useMemo(() => pageAtLine(draft, caretLine), [draft, caretLine]);
  const focus = mode === "visual" ? visualPage : caretPage;

  useEffect(() => {
    if (mode !== "markdown" || pendingJump.current === null) return;
    const line = pendingJump.current;
    pendingJump.current = null;
    jump(line);
  });

  function jump(line: number) {
    const el = area.current;
    if (!el) {
      pendingJump.current = line;
      setMode("markdown");
      return;
    }
    const rows = el.value.split("\n");
    const start = rows.slice(0, line - 1).reduce((n, r) => n + r.length + 1, 0);
    el.focus();
    el.setSelectionRange(start, start + (rows[line - 1]?.length ?? 0));
    el.scrollTop = Math.max(0, (line - 4) * LINE_PX);
    setCaretLine(line);
  }

  async function act<T>(change: () => Promise<T>, after: (out: T) => void) {
    setBusy(true);
    try {
      after(await change());
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const done = (out: { changed: boolean; ignoredSettings: string[] }, what: string) => {
    if (!out.changed) toast.success("Nothing changed");
    else toast.success(out.ignoredSettings.length ? `${what}. Ignored settings no longer in customization.md: ${out.ignoredSettings.join(", ")}` : what);
    setNote("");
  };

  const onSave = (acceptFailingEvals: boolean) => act(
    () => save({ recipeId: view.recipeId, markdown: draft, note: note.trim() || undefined, baseRevision: base.revision, acceptFailingEvals, upstreamVersion: state.merging ?? undefined }),
    (out) => {
      setGate({ evals: out.evals, notRun: out.evalsNotRun, blocked: out.blocked });
      if (out.blocked) return;
      setSaveOpen(false);
      dispatch({ kind: "saved", revision: out.revision, markdown: draft });
      done(out, state.merging ? `Saved, merging upstream v${state.merging}` : "Saved");
    },
  );

  const onRevert = (revision: number) => act(() => revert({ recipeId: view.recipeId, revision }), (out) => done(out, `Reverted to revision ${revision}`));

  const onMerge = () => act(() => fetchUpstream({ recipeId: view.recipeId }), (u) => {
    // Counted on the draft as it stands now; the reducer merges into the same draft.
    const m = merge3(u.base, latestDraft.current, u.theirs, `upstream v${u.version}`);
    setTheirs(u.theirs);
    dispatch({ kind: "merged", base: u.base, theirs: u.theirs, version: u.version });
    toast.success(`${m.applied} upstream change${m.applied === 1 ? "" : "s"} applied${m.conflicts ? `, ${m.conflicts} conflict${m.conflicts === 1 ? "" : "s"} to resolve` : ""}`);
  });

  const failing = gate?.evals.filter((e) => !e.ok).length ?? 0;

  const banner = view.upstream && view.canEdit && (
    <div role="status" className="flex flex-wrap items-center gap-3 border border-warning/60 bg-warning/10 px-3 py-2 text-sm">
      <GitMerge className="h-4 w-4 text-warning" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">Upstream changed.</span> {view.upstream.title} is at v{view.upstream.version}; this copy took v{view.upstream.from}.
        {state.merging ? " Merged into the draft: resolve any conflicts, then save." : ""}
      </span>
      {!state.merging && <button type="button" className={btn} disabled={busy} onClick={() => void onMerge()}><GitMerge className="h-3.5 w-3.5" />Merge v{view.upstream.version}</button>}
    </div>
  );

  const problemsPill = (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn("inline-flex items-center gap-1 text-xs", errors.length ? "font-medium text-destructive" : "text-muted-foreground hover:text-foreground")}>
          {errors.length ? <AlertCircle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5 text-primary" />}
          {errors.length ? `${errors.length} error${errors.length === 1 ? "" : "s"}` : "No errors"}
          {warnings.length > 0 && ` · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`}
        </button>
      </PopoverTrigger>
      {checked.problems.length > 0 && (
        <PopoverContent align="start" className="w-96 rounded-none p-2">
          <ul className="max-h-64 space-y-1 overflow-auto text-xs">
            {checked.problems.map((p, i) => (
              <li key={i}><button type="button" className="w-full text-left hover:bg-muted" onClick={() => jump(p.line)}>
                <span className={cn("font-mono font-semibold", p.level === "error" ? "text-destructive" : "text-muted-foreground")}>Line {p.line}</span> {p.message}
              </button></li>
            ))}
          </ul>
        </PopoverContent>
      )}
    </Popover>
  );

  const saveControl = view.canEdit && (
    <Popover open={saveOpen || !!gate?.blocked} onOpenChange={(o) => { setSaveOpen(o); if (!o && gate?.blocked) setGate(null); }}>
      <PopoverTrigger asChild>
        <button type="button" className={cn(btn, "border-foreground bg-foreground text-background hover:bg-foreground/90")} disabled={busy || !dirty || errors.length > 0}>
          <Save className="h-3.5 w-3.5" />{busy ? "Running evals…" : "Save"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 rounded-none p-3">
        {gate?.blocked ? (
          <div className="space-y-2 text-xs">
            <p className="font-medium text-destructive">{failing} of {gate.evals.length} evals fail on this draft. Save anyway?</p>
            <EvalLines evals={gate.evals} />
            <div className="flex flex-wrap gap-2">
              <button type="button" className={cn(btn, "border-destructive text-destructive")} disabled={busy} onClick={() => void onSave(true)}>Save anyway</button>
              <button type="button" className={btn} disabled={busy} onClick={() => setGate(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void onSave(false); }}>
            <label className="block text-xs font-medium text-muted-foreground" htmlFor="recipe-note">What changed (optional)</label>
            <input id="recipe-note" autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={state.merging ? `Merged upstream v${state.merging}` : "Activity above Next action"}
              className="w-full border border-border bg-background px-2 py-1.5 text-sm" />
            <button type="submit" className={cn(btn, "border-foreground bg-foreground text-background hover:bg-foreground/90")} disabled={busy}>
              <Save className="h-3.5 w-3.5" />{busy ? "Running evals…" : "Run evals and save"}
            </button>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );

  const historySheet = (
    <Sheet>
      <SheetTrigger asChild><button type="button" className={btn} title="Revisions"><History className="h-3.5 w-3.5" />History</button></SheetTrigger>
      <SheetContent side="right" className="w-[28rem] gap-0 overflow-auto rounded-none p-4 sm:max-w-[28rem]">
        <SheetTitle className="text-sm font-semibold">Revisions</SheetTitle>
        <ul className="mt-3 divide-y divide-border text-xs">
          {view.revisions.map((r) => (
            <RevisionRow key={r.revision} r={r} open={open === r.revision} canEdit={view.canEdit} busy={busy}
              onToggle={() => setOpen(open === r.revision ? null : r.revision)} onRevert={() => void onRevert(r.revision)} />
          ))}
        </ul>
      </SheetContent>
    </Sheet>
  );

  const modeToggle = (
    <button type="button" className={btn} onClick={() => setMode(mode === "visual" ? "markdown" : "visual")} title={mode === "visual" ? "Edit customization.md directly" : "Back to the visual editor"}>
      {mode === "visual" ? <><FileCode className="h-3.5 w-3.5" />Markdown</> : <><LayoutList className="h-3.5 w-3.5" />Visual</>}
    </button>
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border pb-3">
      <span className="text-xs text-muted-foreground">Revision {base.revision}{dirty && <span className="font-medium text-foreground"> · unsaved changes</span>}{state.merging ? ` · merging v${state.merging}` : ""}</span>
      {problemsPill}
      {gate && !gate.blocked && <span className="min-w-0 max-w-md truncate text-xs text-muted-foreground" title={gate.notRun ?? undefined}>{gate.notRun ? `Evals not run: ${gate.notRun}` : gate.evals.length ? `Saved · ${gate.evals.length - failing}/${gate.evals.length} evals pass` : "Saved"}</span>}
      <span className="ml-auto flex items-center gap-2">
        {modeToggle}
        {historySheet}
        {view.canEdit && dirty && <button type="button" className={btn} disabled={busy} onClick={() => dispatch({ kind: "reset" })}>Discard</button>}
        {saveControl}
      </span>
    </div>
  );

  const conflictsBox = conflicts.length > 0 && view.canEdit && (
    <section aria-label="Conflicts" className="space-y-3 border border-warning/60 bg-card p-3">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold"><GitMerge className="h-4 w-4 text-warning" />{conflicts.length} conflict{conflicts.length === 1 ? "" : "s"} with upstream</h2>
      <ol className="space-y-3 text-xs">
        {conflicts.map((c, i) => (
          <li key={c.line} className="space-y-1">
            <button type="button" className="font-mono font-semibold hover:underline" onClick={() => jump(c.line)}>Line {c.line}</button>
            <ConflictSide label="Yours" lines={c.ours} />
            <ConflictSide label="Upstream" lines={c.theirs} />
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className={btn} onClick={() => setDraft(resolveConflict(draft, i, "ours"))}>Keep yours</button>
              <button type="button" className={btn} onClick={() => setDraft(resolveConflict(draft, i, "theirs"))}>Take upstream</button>
              <button type="button" className={btn} onClick={() => setDraft(resolveConflict(draft, i, "both"))}>Keep both</button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );

  const editorBody = mode === "visual" ? (
    <LayoutMode markdown={draft} object={caretPage} onPage={setVisualPage} readOnly={!view.canEdit}
      onChange={(text) => dispatch({ kind: "layout", draft: text })} canUndo={state.undo.length > 0} onUndo={() => dispatch({ kind: "undo" })} />
  ) : (
    <div className="relative flex h-full min-h-[50vh] border border-border bg-card font-mono text-xs">
      <div ref={gutter} aria-hidden className="select-none overflow-hidden border-r border-border bg-muted/40 py-2 text-right text-muted-foreground">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} style={{ height: LINE_PX, lineHeight: `${LINE_PX}px` }} className={cn("px-2", errorLines.has(i + 1) && "bg-destructive/15 font-semibold text-destructive")}>{i + 1}</div>
        ))}
      </div>
      <textarea ref={area} aria-label="customization.md" value={draft} readOnly={!view.canEdit} spellCheck={false} wrap="off"
        onChange={(e) => setDraft(e.target.value)}
        onSelect={(e) => setCaretLine(e.currentTarget.value.slice(0, e.currentTarget.selectionStart).split("\n").length)}
        onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
        style={{ lineHeight: `${LINE_PX}px` }}
        className="min-w-0 flex-1 resize-none overflow-auto bg-transparent px-3 py-2 outline-none" />
    </div>
  );

  const preview = <RecipePreview recipe={good} stale={errors.length > 0} focus={focus} />;
  const pane = "h-[calc(100vh-16rem)] min-h-[30rem]";
  const description = `Copied from ${view.forkedFrom.id} v${view.forkedFrom.version} · ${view.bundle === "kept" ? "prompts and logic stay as copied" : "runs on Canon's built-ins"}`;

  return (
    <RecipesSubpage title={view.title} description={description} compact>
      <div className="space-y-3">
        {banner}
        {toolbar}
        {conflictsBox}
        <div className={cn("grid gap-4 lg:grid-cols-[26rem_minmax(0,1fr)]", pane)}>
          <div className="flex min-h-0 flex-col gap-3">
            <div className="min-h-0 flex-1 overflow-auto">{editorBody}</div>
            {view.canEdit
              ? <div className="shrink-0 border border-border bg-card"><RecipeAgentPane recipeId={view.recipeId} state={state} dispatch={dispatch} standIn={view.agentStandIn} /></div>
              : <p className="text-sm text-muted-foreground">Admins and managers edit the workspace&apos;s customizations. <Link className="underline" href="/dashboard/customization">Customization</Link></p>}
          </div>
          <div className="min-h-0 min-w-0">{preview}</div>
        </div>
      </div>
    </RecipesSubpage>
  );
}

function ConflictSide({ label, lines }: { label: string; lines: string[] }) {
  return (
    <div>
      <span className="text-muted-foreground">{label}</span>
      <pre className="max-h-24 overflow-auto border border-border bg-muted/30 p-1 text-[11px] leading-4">{lines.join("\n") || "(nothing)"}</pre>
    </div>
  );
}

function EvalLines({ evals }: { evals: EvalView[] }) {
  return (
    <ul className="max-h-40 space-y-0.5 overflow-auto">
      {evals.map((e) => (
        <li key={e.name} className="flex gap-1">
          {e.ok ? <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-primary" /> : <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />}
          <span>{e.name}{e.detail && <span className="block text-muted-foreground">{e.detail}</span>}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The draft's problems, checked as a save checks them, and an error at each conflict marker a merge left. A kept
 * bundle's prompts and logic are those of the markdown saved.
 */
function checkDraft(draft: string, view: View, saved: string): Checked {
  const frozen = view.bundle === "kept" ? runnable(parseRecipe(saved).recipe) : null;
  const { recipe, problems } = workspaceProblems(draft, { id: view.recipeId, frozen });
  const marks = conflictsIn(draft).map((c): Problem => ({ line: c.line, level: "error", message: "a conflict with upstream: keep yours, take upstream, or edit it" }));
  return { recipe, problems: marks.length ? [...marks, ...problems].sort((a, b) => a.line - b.line) : problems };
}

function RevisionRow({ r, open, canEdit, busy, onToggle, onRevert }: { r: Revision; open: boolean; canEdit: boolean; busy: boolean; onToggle: () => void; onRevert: () => void }) {
  return (
    <li className="py-2">
      <div className="flex items-start justify-between gap-2">
        <button type="button" className="min-w-0 text-left" aria-expanded={open} onClick={onToggle}>
          <span className="font-mono font-semibold">#{r.revision}</span>{r.status === "current" && <span className="ml-1 text-primary">in force</span>}
          <span className="block text-muted-foreground">{r.author} · {new Date(r.createdAt).toLocaleString()} · +{r.diff.added} −{r.diff.removed}</span>
          {r.note && <span className="block">{r.note}</span>}
        </button>
        {canEdit && r.status !== "current" && (
          <button type="button" className={btn} disabled={busy} onClick={onRevert}><RotateCcw className="h-3.5 w-3.5" />Revert</button>
        )}
      </div>
      {open && <div className="mt-2"><DiffView text={r.diff.text} /></div>}
    </li>
  );
}
