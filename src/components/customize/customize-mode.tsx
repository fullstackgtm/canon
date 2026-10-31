"use client";

import { IntegrationGate } from "@/components/integration-gate";

/**
 * Customize mode (prototype): the pencil in the lower-right dock. Hover it for what this page can change; click it and the
 * page dims, the cursor becomes a selector, and whatever you point at lights up. Start typing (or click) and a comment
 * pins to that spot; Enter queues it, and the live page redraws as each queued change lands. The editor's own chrome is
 * dark and rounded so it never reads as part of the page being edited.
 *
 * A page that knows how to change itself registers an adapter (the deal page does, from its recipe). On any other page
 * a comment is kept as a request.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, CornerDownLeft, Loader2, Pencil, RotateCcw, Save, Undo2, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { trayLauncherClassName } from "@/components/floating-tray-dock";
import { cn } from "@/lib/utils";

export type CustomizeTarget = { title: string; purpose?: string; when?: string; reads: string[]; does: string[]; writes: string[] };
export type CustomizeJob = { id: string; request: string; where: string; status: "queued" | "working" | "done" | "failed"; summary?: string; by?: string; ms?: number; route?: string; diff?: string; kind?: "layout" | "behavior" };
export type CustomizeAdapter = {
  label: string;
  detail?: string;
  describe: (el: HTMLElement) => CustomizeTarget | null;
  /** Queue an instruction about `el`; it applies to the page as soon as it is worked out, without asking. */
  /** `pointed` says in words what was under the pointer: the exact element and the area around it. */
  submit: (text: string, el: HTMLElement | null, pointed: string) => void;
  jobs: CustomizeJob[];
  undo: () => void;
  reset: () => void;
  kept: number;
  /** Instructions still queued or running; saving waits for them. */
  pending: boolean;
  /** Save the edits as the workspace's recipe. */
  save: (acceptFailingEvals?: boolean) => void;
  saved: { state: "saving" | "saved" | "blocked" | "failed"; message?: string } | null;
  stages?: { options: { value: string | null; label: string }[]; value: string | null; set: (v: string | null) => void };
};

type Ctx = { customizing: boolean; setCustomizing: (on: boolean) => void; adapter: CustomizeAdapter | null; setAdapter: (a: CustomizeAdapter | null) => void };
const CustomizeContext = createContext<Ctx | null>(null);
export const useCustomizeMode = () => useContext(CustomizeContext);

/** A page registers how it changes itself while it is mounted. */
export function useCustomizeAdapter(adapter: CustomizeAdapter | null, deps: readonly unknown[]) {
  const ctx = useCustomizeMode();
  const set = ctx?.setAdapter;
  useEffect(() => {
    set?.(adapter);
    return () => set?.(null);
    // The adapter is rebuilt every render; it is registered again only when what it shows changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, ...deps]);
}

export function CustomizeProvider({ children }: { children: ReactNode }) {
  const [customizing, setCustomizing] = useState(false);
  const [adapter, setAdapter] = useState<CustomizeAdapter | null>(null);
  return (
    <CustomizeContext.Provider value={{ customizing, setCustomizing, adapter, setAdapter }}>
      {children}
      {customizing && <CustomizeOverlay />}
    </CustomizeContext.Provider>
  );
}

// The editor's chrome: ink, rounded, violet. Nothing on the page itself looks like this.
const CHROME = "rounded-xl border border-white/10 bg-stone-950 text-stone-100 shadow-2xl";
const CURSOR = `url("data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><circle cx="6" cy="6" r="4.5" fill="#7c3aed" stroke="white" stroke-width="1.5"/><path d="M12 16l9-9 3 3-9 9h-3z" fill="#1c1917" stroke="white" stroke-width="1.2"/></svg>')}") 6 6, crosshair`;

/**
 * The pencil, left of the activity tray, and its one tray: what this page can change, the changes asked for as they
 * are worked on, and saving them. Hover shows it; while customizing it stays open.
 */
function CustomizeTrayEnabled() {
  const ctx = useCustomizeMode();
  const [hovered, setHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const later = () => { cancel(); timer.current = setTimeout(() => setHovered(false), 150); };
  if (!ctx) return null;
  const { customizing, setCustomizing, adapter } = ctx;
  const jobs = adapter?.jobs ?? [];
  return (
    <Popover open={customizing || hovered} onOpenChange={(open) => { if (!customizing) setHovered(open); }}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={customizing ? "Stop customizing" : "Customize this page"} aria-pressed={customizing}
          onMouseEnter={() => { cancel(); setHovered(true); }} onMouseLeave={later}
          onClick={(e) => { e.preventDefault(); setCustomizing(!customizing); setHovered(false); }}
          className={cn(trayLauncherClassName, customizing && "border-violet-500 bg-stone-950 text-violet-300 ring-4 ring-violet-500/30")}>
          {customizing ? <X className="size-5" aria-hidden /> : <Pencil className="size-5" aria-hidden />}
          {!customizing && (adapter?.kept ?? 0) > 0 && <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-violet-600 text-[10px] font-semibold text-white ring-2 ring-background">{adapter!.kept}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent data-customize-chrome side="top" align="end" sideOffset={12} onMouseEnter={cancel} onMouseLeave={later}
        onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}
        className={cn(CHROME, "w-[360px] p-0")}>
        <div className="flex items-start gap-2 border-b border-white/10 px-4 py-3">
          <Pencil className="mt-0.5 size-3.5 shrink-0 text-violet-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{customizing ? "Customizing" : "Customize this page"}{adapter && <span className="font-normal text-stone-400"> · {adapter.label}{adapter.detail ? `, ${adapter.detail}` : ""}</span>}</p>
            <p className="mt-0.5 text-xs text-stone-400">
              {!adapter ? "Nothing here can change yet: only pages drawn by a customization can."
                : customizing ? "Point at an outlined part and start typing. Each change lands on the page as it's done."
                : "Click the pencil, point at an outlined part of the page, and type how it should work. The page redraws so you can judge it."}
            </p>
          </div>
          {customizing && <button type="button" onClick={() => setCustomizing(false)} className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-stone-400 ring-1 ring-white/15 hover:text-white">Esc · Done</button>}
        </div>
        {adapter?.stages && <div className="border-b border-white/10 px-4 py-2"><StagePicker stages={adapter.stages} /></div>}
        {jobs.length > 0 && <div className="max-h-[50vh] overflow-y-auto px-2 py-2 text-xs"><JobList jobs={jobs} /></div>}
        {adapter && (adapter.kept > 0 || adapter.saved) && <div className="border-t border-white/10 px-3 py-2 text-xs"><SaveBar adapter={adapter} /></div>}
      </PopoverContent>
    </Popover>
  );
}

function StagePicker({ stages }: { stages: NonNullable<CustomizeAdapter["stages"]> }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px]">
      <span className="text-stone-500">See it in</span>
      {stages.options.map((o) => (
        <button key={o.value ?? "now"} type="button" onClick={() => stages.set(o.value)}
          className={cn("rounded-full border px-2 py-0.5", stages.value === o.value ? "border-violet-500 bg-violet-500/20 text-white" : "border-white/15 text-stone-300 hover:border-white/40")}>{o.label}</button>
      ))}
    </div>
  );
}

const visible = (el: HTMLElement) => el.getBoundingClientRect().height > 0;

/**
 * The recipe section a point names, or null. Only what the page's recipe draws can change, so only its sections light
 * up; everything Canon draws itself stays dim. In the gaps between sections, the nearest one.
 */
function areaAt(x: number, y: number): HTMLElement | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (!(el instanceof HTMLElement) || el.closest("[data-customize-chrome], [data-slot=floating-tray-dock]")) continue;
    const section = el.closest<HTMLElement>("[data-shape-section]");
    if (section) return visible(section) ? section : null;
    const page = el.closest<HTMLElement>("[data-shape-page]");
    if (!page) return null;
    const inside = [...page.querySelectorAll<HTMLElement>("[data-shape-section]")].filter(visible);
    if (!inside.length) return null;
    const dist = (s: HTMLElement) => { const r = s.getBoundingClientRect(); return y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0; };
    return inside.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  }
  return null;
}

/** The element right under the pointer, past the editor's own chrome. */
function leafAt(x: number, y: number): HTMLElement | null {
  return (document.elementsFromPoint(x, y).find((el) => el instanceof HTMLElement && !el.closest("[data-customize-chrome], [data-slot=floating-tray-dock]") && el.closest("main, #main")) as HTMLElement | undefined) ?? null;
}

const textOf = (el: Element | null | undefined, max = 80) => (el?.getAttribute("aria-label") ?? el?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * What was pointed at, in words, for the model: the element itself and what it is (the section's title, a button, one
 * of the section's parts, or something its component draws), then the area it sits in.
 */
function pointedAt(leaf: HTMLElement | null, area: HTMLElement): string {
  const titleEl = area.querySelector("h1, h2, h3, summary");
  const heading = titleEl?.textContent?.trim();
  const part = leaf?.closest<HTMLElement>("[data-part]");
  const thing = leaf?.closest("button, a, [role=status], span, td, th, label, h1, h2, h3, summary, p") ?? leaf;
  const what = !thing || thing === area ? null
    : part && area.contains(part) ? `the section's "${part.dataset.part}" part, reading "${textOf(part, 60)}"`
    : titleEl && (thing === titleEl || titleEl.contains(thing)) ? `the section's title, reading "${textOf(titleEl, 60)}"`
    : thing.tagName === "BUTTON" || thing.tagName === "A" ? `a button reading "${textOf(thing, 60)}"`
    : `a control or text the section's component draws, reading "${textOf(thing, 60)}"`;
  return [what, heading ? `in the area headed "${heading}"` : `in an area reading "${textOf(area, 80)}"`].filter(Boolean).join(" ");
}


function CustomizeOverlay() {
  const ctx = useCustomizeMode()!;
  const { adapter, setCustomizing } = ctx;
  const [hover, setHover] = useState<HTMLElement | null>(null);
  const [pinned, setPinned] = useState<HTMLElement | null>(null);
  const leaf = useRef<HTMLElement | null>(null);
  const [pointed, setPointed] = useState("");
  const [text, setText] = useState("");
  const [rect, setRect] = useState<DOMRect | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const target = pinned ?? hover;
  const selecting = true;

  // Keep the spotlight on its element, and the outlines on every editable section, as the page scrolls or redraws.
  const [editable, setEditable] = useState<DOMRect[]>([]);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setRect(target?.isConnected ? target.getBoundingClientRect() : null);
      const next = [...document.querySelectorAll<HTMLElement>("[data-shape-section]")].filter(visible).map((el) => el.getBoundingClientRect());
      setEditable((was) => (was.length === next.length && was.every((r, i) => r.top === next[i].top && r.height === next[i].height) ? was : next));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [target]);

  const close = useCallback(() => { setPinned(null); setText(""); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { if (pinned) close(); else setCustomizing(false); return; }
      // Typing over an area opens its comment with what was typed.
      if (selecting && !pinned && hover && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setPinned(hover);
        setPointed(pointedAt(leaf.current, hover));
        setText(e.key);
        requestAnimationFrame(() => { const i = inputRef.current; if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, pinned, hover, close, setCustomizing]);

  function submit() {
    const request = text.trim();
    if (!request || !pinned) return;
    adapter?.submit(request, pinned, pointed);
    close();
  }

  const info = pinned ? adapter?.describe(pinned) ?? null : null;
  const hoverInfo = !pinned && hover ? adapter?.describe(hover) ?? null : null;
  const bubbleTop = rect ? (rect.bottom + 260 < window.innerHeight ? rect.bottom + 10 : Math.max(12, rect.top - 270)) : 0;
  const bubbleLeft = rect ? Math.min(Math.max(12, rect.left), window.innerWidth - 432) : 0;

  return (
    <>
      {selecting && (
        // The page under the selector: dimmed, inert, and the pointed-at area cut out bright.
        <div data-customize-chrome className="fixed inset-0 z-[45]" style={{ cursor: pinned ? "default" : hover ? CURSOR : "not-allowed" }}
          onMouseMove={(e) => { if (!pinned) { setHover(areaAt(e.clientX, e.clientY)); leaf.current = leafAt(e.clientX, e.clientY); } }}
          onMouseDown={(e) => { e.preventDefault(); if (pinned) { if (!text.trim()) close(); return; } const a = areaAt(e.clientX, e.clientY); if (a) { setPinned(a); setPointed(pointedAt(leafAt(e.clientX, e.clientY), a)); requestAnimationFrame(() => inputRef.current?.focus()); } }}
          onWheel={(e) => { window.scrollBy(0, e.deltaY); document.querySelector("main")?.scrollBy(0, e.deltaY); }}>
          {rect ? (
            <div className="pointer-events-none fixed rounded-md outline outline-2 outline-violet-500 transition-all duration-100"
              style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8, boxShadow: "0 0 0 200vmax rgba(28,25,23,0.45)" }} />
          ) : <div className="pointer-events-none fixed inset-0 bg-stone-950/45" />}
          {editable.map((r, i) => (
            // What can change: each recipe section, faintly outlined over the dimmed page.
            <div key={i} className="pointer-events-none fixed rounded-md border border-dashed border-violet-300/70" style={{ top: r.top - 4, left: r.left - 4, width: r.width + 8, height: r.height + 8 }} />
          ))}
        </div>
      )}

      {selecting && hoverInfo && rect && (
        <div data-customize-chrome className="pointer-events-none fixed z-[46] rounded-full bg-violet-600 px-2.5 py-0.5 text-[11px] font-medium text-white shadow" style={{ top: Math.max(4, rect.top - 26), left: rect.left }}>
          {hoverInfo.title} <span className="text-violet-200">· type to change it</span>
        </div>
      )}

      {pinned && info && rect && (
        <div data-customize-chrome className={cn(CHROME, "fixed z-[60] w-[420px] p-3")} style={{ top: bubbleTop, left: bubbleLeft }}>
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold"><span className="size-2 rounded-full bg-violet-500" />{info.title}{info.when && <span className="font-normal text-stone-400">· {info.when}</span>}</div>
          {info.purpose && <p className="mb-2 line-clamp-2 text-[11px] text-stone-400">{info.purpose}</p>}
          {(info.reads.length > 0 || info.does.length > 0 || info.writes.length > 0) && (
            <div className="mb-2 space-y-1 text-[11px]">
              {info.reads.length > 0 && <Row label="Reads" items={info.reads} tone="text-sky-300 border-sky-400/30" />}
              {info.does.length > 0 && <Row label="Does" items={info.does} tone="text-stone-200 border-white/20" />}
              {info.writes.length > 0 && <Row label="Writes" items={info.writes} tone="text-emerald-300 border-emerald-400/30" />}
            </div>
          )}
          <textarea ref={inputRef} rows={2} value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder={adapter ? "What should this do instead? e.g. only show it in Close, fold it, add a button to…" : "What should this do?"}
            className="w-full resize-none rounded-lg bg-white/5 px-2 py-1.5 text-sm text-white outline-none ring-1 ring-white/10 placeholder:text-stone-500 focus:ring-violet-500" />
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-stone-500">
            <span><CornerDownLeft className="inline size-3" /> to do it · keep pointing and typing to queue more</span>
            <button type="button" onClick={submit} disabled={!text.trim()} className="rounded-md bg-violet-600 px-2.5 py-1 font-medium text-white disabled:opacity-40">Do it</button>
          </div>
        </div>
      )}

    </>
  );
}

/** Unsaved edits, Undo and Save; what the last save did. */
function SaveBar({ adapter }: { adapter: CustomizeAdapter }) {
  const s = adapter.saved;
  if (!adapter.kept && !s) return null;
  return (
    <div className="text-stone-400">
      {adapter.kept > 0 && (
        <div className="flex items-center gap-3 whitespace-nowrap">
          <span>{adapter.kept} unsaved</span>
          <button type="button" onClick={adapter.undo} className="inline-flex items-center gap-1 hover:text-white"><Undo2 className="size-3" /> Undo</button>
          <button type="button" onClick={adapter.reset} className="inline-flex items-center gap-1 hover:text-white"><RotateCcw className="size-3" /> Reset</button>
          <button type="button" disabled={s?.state === "saving" || adapter.pending} title={adapter.pending ? "Wait for the changes still being worked on" : undefined} onClick={() => adapter.save()} className="ml-auto inline-flex items-center gap-1 rounded-md bg-violet-600 px-2.5 py-1 font-medium text-white disabled:opacity-50">
            {s?.state === "saving" ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />} Save for everyone
          </button>
        </div>
      )}
      {s?.message && (
        <p className={cn("mt-1", s.state === "saved" ? "text-emerald-300" : s.state === "failed" || s.state === "blocked" ? "text-amber-200" : "")}>
          {s.message}{s.state === "blocked" && <> <button type="button" disabled={adapter.pending} onClick={() => adapter.save(true)} className="underline disabled:opacity-50">Save anyway</button></>}
        </p>
      )}
    </div>
  );
}

function JobList({ jobs }: { jobs: CustomizeJob[] }) {
  return (
    <ul className="space-y-1">
      {jobs.map((j) => (
        <li key={j.id} className="flex items-start gap-2 rounded-lg px-1 py-0.5" title={j.route}>
          <span className="mt-0.5 shrink-0">
            {j.status === "working" ? <Loader2 className="size-3 animate-spin text-violet-400" /> : j.status === "queued" ? <span className="block size-3 rounded-full border border-stone-500" /> : j.status === "done" ? <Check className="size-3 text-emerald-400" /> : <X className="size-3 text-red-400" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="text-stone-500">{j.where}: </span><span className="text-stone-100">{j.request}</span>
            {j.status === "working" && <span className="block text-stone-500">working…</span>}
            {j.summary && <span className={cn("block", j.status === "failed" ? "text-red-300" : "text-stone-400")}>{j.kind === "behavior" && <span className="mr-1 rounded bg-sky-500/20 px-1 text-sky-200">how it works</span>}{j.summary}{j.by ? ` · ${j.by}` : ""}{j.ms ? ` · ${(j.ms / 1000).toFixed(1)}s` : ""}</span>}
            {j.diff && j.status === "done" && (
              <details className="mt-0.5">
                <summary className="cursor-pointer text-stone-500 hover:text-stone-300">Show the change</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-1.5 font-mono text-[10px] leading-4">{j.diff.split("\n").map((l, i) => <span key={i} className={cn("block", l.startsWith("+") ? "text-emerald-300" : l.startsWith("-") ? "text-red-300" : "text-stone-500")}>{l}</span>)}</pre>
              </details>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Row({ label, items, tone }: { label: string; items: string[]; tone: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="w-11 text-stone-500">{label}</span>
      {items.map((i) => <span key={i} className={cn("rounded border px-1.5 py-px", tone)}>{i}</span>)}
    </div>
  );
}

export function CustomizeTray() {
  return <IntegrationGate feature="chatgpt"><CustomizeTrayEnabled /></IntegrationGate>;
}
