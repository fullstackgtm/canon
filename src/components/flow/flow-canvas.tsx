"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, Minus, Plus, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A flow as a canvas of states (after tanishqkancharla/flow-preview): nodes laid out by parent depth, arrows from
 * parent to child labeled with the action between them, and a pane for the selected node. Generic over the domain:
 * every editor that builds a flow (sequence steps, LinkedIn cadences, automations, pipelines, deal play steps) maps
 * its draft or saved value to FlowNodes and shows it here next to its own list editor (FlowSwitch).
 */

export type FlowTone = "done" | "active" | "planned" | "failed" | "exit" | "neutral";

export type FlowNode = {
  id: string;
  title: string;
  /** The action or condition that leads here from the parent, drawn on the incoming arrow. */
  action?: string;
  parent?: string;
  /** Order within its column. */
  row: number;
  tone?: FlowTone;
  /** A short figure on the node: a count, a rate, a delay. */
  metric?: string;
  /** The node body on the canvas. Keep it small. */
  card?: ReactNode;
  /** The selected node's full view. Defaults to the card. */
  detail?: ReactNode;
  /** Changes when the node's content changes; a changed fingerprint clears its review mark. */
  fingerprint?: string;
};

export type FlowScenario = { id: string; title: string; initial?: string; nodes: readonly FlowNode[] };

/** Nodes in order as a chain: each one's parent is the one before it. */
export function chain(nodes: ReadonlyArray<Omit<FlowNode, "parent" | "row">>): FlowNode[] {
  return nodes.map((n, i) => ({ ...n, row: 0, parent: i > 0 ? nodes[i - 1].id : undefined }));
}

const NODE_W = 216;
const NODE_H = 96;
const COL_GAP = 88;
const ROW_GAP = 24;
const PAD = 28;

const TONE: Record<FlowTone, string> = {
  done: "bg-primary",
  active: "bg-warning",
  planned: "bg-muted-foreground/40",
  failed: "bg-destructive",
  exit: "bg-foreground/70",
  neutral: "bg-border",
};

type Placed = { node: FlowNode; x: number; y: number };

/**
 * Nodes with every parent placed before its children. A parent that is missing, or that only a cycle reaches (rows
 * from module data can point at each other), is dropped, so the node becomes a root.
 */
function ordered(nodes: readonly FlowNode[]): FlowNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const out: FlowNode[] = [];
  const seen = new Set<string>();
  let rest = nodes.map((n) => (n.parent !== undefined && (!ids.has(n.parent) || n.parent === n.id) ? { ...n, parent: undefined } : n));
  while (rest.length) {
    const ready = rest.filter((n) => n.parent === undefined || seen.has(n.parent));
    // Only cycles are left: cut the first one's parent and go on.
    const take = ready.length ? ready : [{ ...rest[0], parent: undefined }];
    for (const n of take) { out.push(n); seen.add(n.id); }
    const taken = new Set(take.map((n) => n.id));
    rest = rest.filter((n) => !taken.has(n.id));
  }
  return out;
}

function layout(nodes: readonly FlowNode[]): { placed: Map<string, Placed>; width: number; height: number } {
  const depth = new Map<string, number>();
  for (const n of nodes) depth.set(n.id, n.parent !== undefined ? (depth.get(n.parent) ?? 0) + 1 : 0);
  const columns = new Map<number, FlowNode[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    columns.set(d, [...(columns.get(d) ?? []), n]);
  }
  const placed = new Map<string, Placed>();
  let height = NODE_H;
  for (const [d, col] of columns) {
    [...col].sort((a, b) => a.row - b.row).forEach((node, i) => {
      const y = i * (NODE_H + ROW_GAP);
      placed.set(node.id, { node, x: d * (NODE_W + COL_GAP), y });
      height = Math.max(height, y + NODE_H);
    });
  }
  const width = Math.max(NODE_W, ...[...columns.keys()].map((d) => d * (NODE_W + COL_GAP) + NODE_W));
  return { placed, width, height };
}

const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const notify = () => listeners.forEach((fn) => fn());

/** A JSON value in this browser's localStorage, shared by every component reading the same key. */
function useStored<T>(key: string, fallback: T): [T, (next: T) => void] {
  const raw = useSyncExternalStore(subscribe, () => localStorage.getItem(key), () => null);
  const value = useMemo(() => { try { return raw === null ? fallback : JSON.parse(raw) as T; } catch { return fallback; } }, [raw]); // eslint-disable-line react-hooks/exhaustive-deps
  return [value, (next: T) => { localStorage.setItem(key, JSON.stringify(next)); notify(); }];
}

function ReviewBox({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
  return <button type="button" role="checkbox" aria-checked={checked} aria-label={`Reviewed: ${label}`}
    onClick={(e) => { e.stopPropagation(); onToggle(); }}
    className={cn("grid size-4 shrink-0 place-items-center rounded border transition-colors",
      checked ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:border-foreground/40")}>
    {checked && <Check className="size-3" strokeWidth={3} />}
  </button>;
}

/**
 * The canvas, its zoom controls and the selected node's pane. `outline` adds a tree list of the nodes; `reviews` adds
 * a per-node reviewed mark kept in this browser. `empty` shows when there are no nodes.
 */
export function FlowCanvas({ scenario, height = 420, outline = false, reviews = false, empty = "Nothing to show yet." }: {
  scenario: FlowScenario; height?: number; outline?: boolean; reviews?: boolean; empty?: ReactNode;
}) {
  const nodes = useMemo(() => ordered(scenario.nodes), [scenario.nodes]);
  const { placed, width, height: contentH } = useMemo(() => layout(nodes), [nodes]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const children = useMemo(() => {
    const m = new Map<string, FlowNode[]>();
    for (const n of nodes) if (n.parent) m.set(n.parent, [...(m.get(n.parent) ?? []), n].sort((a, b) => a.row - b.row));
    return m;
  }, [nodes]);
  const [picked, setPicked] = useState<string | null>(null);
  // A draft edit can remove the picked node: fall back to the initial one, then the first.
  const selected = picked !== null && byId.has(picked) ? picked : scenario.initial !== undefined && byId.has(scenario.initial) ? scenario.initial : nodes[0]?.id;
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useStored<Record<string, string>>(`canon.flow-reviews.${scenario.id}`, {});
  const print = (n: FlowNode) => n.fingerprint ?? `${n.title}|${n.metric ?? ""}|${n.tone ?? ""}`;
  const isReviewed = (n: FlowNode) => reviews && marks[n.id] === print(n);
  const toggle = (n: FlowNode) => {
    const next = { ...marks };
    if (isReviewed(n)) delete next[n.id]; else next[n.id] = print(n);
    setMarks(next);
  };

  const reveal = useCallback((id: string | undefined, behavior: ScrollBehavior = "smooth", scale = zoom) => {
    const p = id ? placed.get(id) : undefined, el = viewport.current;
    if (!p || !el) return;
    el.scrollTo({ left: (p.x + NODE_W / 2) * scale + PAD - el.clientWidth / 2, top: (p.y + NODE_H / 2) * scale + PAD - el.clientHeight / 2, behavior });
  }, [placed, zoom]);
  useLayoutEffect(() => { reveal(selected, "auto"); }, [scenario.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Native, non-passive: React's wheel listener is passive, so it can't stop the browser zooming the page too.
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => Math.min(1.5, Math.max(0.4, z - e.deltaY * 0.002)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  if (nodes.length === 0) return <div className="grid place-items-center rounded-lg bg-muted/30 p-8 text-sm text-muted-foreground ring-1 ring-border">{empty}</div>;

  const select = (id: string) => { setPicked(id); reveal(id); };
  const onKey = (e: React.KeyboardEvent) => {
    // Arrow keys inside a pane's own controls move the caret or the value, not the selection.
    if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable=true], [role=combobox], [role=listbox]")) return;
    const cur = selected ? byId.get(selected) : undefined;
    if (!cur) return;
    const sibs = cur.parent ? children.get(cur.parent) ?? [] : nodes.filter((n) => !n.parent);
    const i = sibs.findIndex((n) => n.id === cur.id);
    const next = e.key === "ArrowRight" ? children.get(cur.id)?.[0]
      : e.key === "ArrowLeft" ? (cur.parent ? byId.get(cur.parent) : undefined)
      : e.key === "ArrowDown" ? sibs[i + 1]
      : e.key === "ArrowUp" ? sibs[i - 1] : undefined;
    if (next) { e.preventDefault(); select(next.id); }
  };

  const tree: Array<{ node: FlowNode; depth: number }> = [];
  const walk = (n: FlowNode, d: number) => { tree.push({ node: n, depth: d }); for (const c of children.get(n.id) ?? []) walk(c, d + 1); };
  nodes.filter((n) => !n.parent).sort((a, b) => a.row - b.row).forEach((n) => walk(n, 0));

  const current = selected ? byId.get(selected) : undefined;
  const path: FlowNode[] = [];
  for (let n = current; n; n = n.parent ? byId.get(n.parent) : undefined) path.unshift(n);
  const onPath = new Set(path.map((p) => p.id));
  // As tall as the flow needs (room for the zoom bar), up to `height`; it stretches to a taller pane beside it.
  const fit = Math.max(180, Math.min(height, contentH + PAD * 2 + 40));

  // Container queries, not the viewport: the same canvas sits in a full page, a card and a dialog.
  return <div className="@container"><div className={cn("grid grid-cols-1 gap-3 @2xl:grid-cols-[minmax(0,1fr)_260px]", outline && "@5xl:grid-cols-[190px_minmax(0,1fr)_260px]")} onKeyDown={onKey}>
    {outline && <nav aria-label={`${scenario.title} outline`} style={{ maxHeight: height }} className="hidden min-h-0 flex-col overflow-auto rounded-lg bg-card p-2 ring-1 ring-border @5xl:flex">
      {reviews && <div className="px-2 pb-2 pt-1 text-xs text-muted-foreground">{nodes.filter(isReviewed).length}/{nodes.length} reviewed</div>}
      {tree.map(({ node, depth }) => <div key={node.id} role="button" tabIndex={-1} onClick={() => select(node.id)}
        className={cn("flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-sm", node.id === selected ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60")}
        style={{ paddingLeft: 8 + depth * 12 }}>
        <span className={cn("size-1.5 shrink-0 rounded-full", TONE[node.tone ?? "neutral"])} />
        <span className="min-w-0 flex-1 truncate">{node.title}</span>
        {reviews && <ReviewBox checked={isReviewed(node)} onToggle={() => toggle(node)} label={node.title} />}
      </div>)}
    </nav>}

    <div className="relative min-h-0 overflow-hidden rounded-lg bg-muted/30 ring-1 ring-border" style={{ minHeight: fit, maxHeight: height }}>
      <div ref={viewport} tabIndex={0} aria-label={`${scenario.title} canvas`}
        className="absolute inset-0 overflow-auto outline-none [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:12px_12px]">
        <div style={{ width: width * zoom + PAD * 2, height: contentH * zoom + PAD * 2, padding: PAD }}>
          <div className="relative origin-top-left transition-transform duration-200" style={{ width, height: contentH, transform: `scale(${zoom})` }}>
            <svg className="pointer-events-none absolute inset-0 overflow-visible" width={width} height={contentH} aria-hidden>
              {nodes.filter((n) => n.parent && placed.has(n.parent)).map((n) => {
                const a = placed.get(n.parent!)!, b = placed.get(n.id)!;
                const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, mx = (x1 + x2) / 2;
                const stroke = onPath.has(n.id) ? "stroke-primary" : "stroke-muted-foreground/40";
                return <g key={n.id}>
                  <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 6},${y2}`} fill="none" className={stroke} strokeWidth={onPath.has(n.id) ? 2 : 1.25} />
                  <path d={`M${x2 - 7},${y2 - 4} L${x2},${y2} L${x2 - 7},${y2 + 4}`} fill="none" className={stroke} strokeWidth={1.5} />
                  {n.action && <foreignObject x={x2 - COL_GAP + 6} y={y2 - 20} width={COL_GAP - 14} height={16}>
                    <div className="truncate rounded bg-background/90 px-1 text-center text-[10px] leading-4 text-muted-foreground" title={n.action}>{n.action}</div>
                  </foreignObject>}
                </g>;
              })}
            </svg>
            {[...placed.values()].map(({ node, x, y }) => {
              const sel = node.id === selected, done = isReviewed(node);
              return <div key={node.id} className="absolute" style={{ left: x, top: y, width: NODE_W, height: NODE_H }}>
                <button type="button" onClick={() => select(node.id)} aria-pressed={sel}
                  className={cn("flex h-full w-full flex-col rounded-lg bg-background p-3 text-left shadow-sm ring-1 ring-foreground/15 transition-shadow hover:ring-foreground/30",
                    sel && "ring-2 ring-primary")}>
                  <div className="flex w-full items-center gap-2">
                    <span className={cn("size-2 shrink-0 rounded-full", TONE[node.tone ?? "neutral"])} />
                    <span className={cn("min-w-0 flex-1 truncate text-sm", sel ? "font-semibold text-primary" : "font-medium")}>{node.title}</span>
                    {node.metric && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{node.metric}</span>}
                  </div>
                  {node.card && <div className={cn("mt-1.5 min-h-0 w-full flex-1 overflow-hidden text-xs text-muted-foreground", done && "opacity-40")}>{node.card}</div>}
                </button>
                {done && <span className="absolute right-2 top-[-8px] grid size-5 place-items-center rounded-full bg-primary text-primary-foreground shadow"><Check className="size-3" strokeWidth={3} /></span>}
              </div>;
            })}
          </div>
        </div>
      </div>
      <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-card p-1 shadow-sm ring-1 ring-border">
        <button type="button" aria-label="Zoom out" className="rounded p-1 hover:bg-accent" onClick={() => setZoom((z) => Math.max(0.4, z - 0.1))}><Minus className="size-3.5" /></button>
        <span className="w-10 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="Zoom in" className="rounded p-1 hover:bg-accent" onClick={() => setZoom((z) => Math.min(1.5, z + 0.1))}><Plus className="size-3.5" /></button>
        <button type="button" aria-label="Reset view" className="rounded p-1 hover:bg-accent" onClick={() => { setZoom(1); setPicked(null); requestAnimationFrame(() => reveal(scenario.initial ?? nodes[0]?.id, "smooth", 1)); }}><RotateCcw className="size-3.5" /></button>
      </div>
    </div>

    {current && <aside aria-label="Selected step" style={{ maxHeight: height }} className="flex min-h-0 flex-col overflow-hidden rounded-lg bg-card ring-1 ring-border">
      <div className="border-b p-3">
        {path.length > 1 && <div className="mb-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          {path.map((p, i) => <span key={p.id} className="flex items-center gap-1">{i > 0 && <span>›</span>}
            <button type="button" className="hover:text-foreground hover:underline" onClick={() => select(p.id)}>{p.title}</button></span>)}
        </div>}
        <div className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", TONE[current.tone ?? "neutral"])} />
          <h3 className="min-w-0 flex-1 truncate font-semibold">{current.title}</h3>
          {reviews && <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ReviewBox checked={isReviewed(current)} onToggle={() => toggle(current)} label={current.title} />Reviewed
          </label>}
        </div>
        {current.action && <p className="mt-1 text-xs text-muted-foreground">{current.action}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 text-sm">{current.detail ?? current.card}</div>
      {(current.parent || (children.get(current.id) ?? []).length > 0) && <div className="flex flex-wrap justify-end gap-1.5 border-t p-2">
        {current.parent && <button type="button" className="view-action" onClick={() => select(current.parent!)}>Previous</button>}
        {(children.get(current.id) ?? []).map((c) => <button key={c.id} type="button" className="view-action" onClick={() => select(c.id)}>{c.action ?? c.title} →</button>)}
      </div>}
    </aside>}
  </div></div>;
}

/** Label/value rows for a node's card or pane. */
export function FlowRows({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
    {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="truncate text-foreground">{v}</dd></div>)}
  </dl>;
}

/**
 * An editor's List and Canvas views of the same flow, switched by a segmented control. The choice is kept per `id`
 * in this browser; `initial` (the canvas unless set) until they pick.
 */
export function FlowSwitch({ id, list, canvas, label = "View", initial = "canvas" }: { id: string; list: ReactNode; canvas: ReactNode; label?: string; initial?: "canvas" | "list" }) {
  const [view, setView] = useStored<"canvas" | "list">(`canon.flow-view.${id}`, initial);
  return <div className="space-y-2">
    <div role="tablist" aria-label={label} className="inline-flex rounded-md bg-muted p-0.5 text-xs">
      {(["canvas", "list"] as const).map((v) => <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
        className={cn("rounded px-2.5 py-1 capitalize", view === v ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}>{v}</button>)}
    </div>
    {view === "canvas" ? canvas : list}
  </div>;
}
